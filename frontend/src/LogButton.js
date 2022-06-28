import ArticleIcon from "@mui/icons-material/Article";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import IconButton from "@material-ui/core/IconButton";


const LogButton = ({ onClick, disabled }) => {
    return (
        <FormControlLabel disabled={disabled}
            control={
                <IconButton onClick={onClick}>
                    <ArticleIcon />
                </IconButton>
            }
        />
    );
};


export default LogButton;
